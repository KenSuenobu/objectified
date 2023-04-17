import {NextPage} from 'next';
import {Box, Stack} from '@mui/system';
import ListHeader from '../../components/ListHeader';
import React, {useEffect, useRef, useState} from 'react';
import LoadingMessage from '../../components/LoadingMessage';
import {
    Accordion, AccordionDetails,
    AccordionSummary,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle, FormControl, InputLabel, Select, SelectChangeEvent, Table, TableBody,
    TableCell, TableContainer,
    TableHead,
    TableRow,
    TextField, Typography
} from '@mui/material';
import { StackItem } from '../../components/StackItem';
import {NamespaceDto} from 'objectified-data/dist/src/dto/namespace.dto';
import axios from 'axios';
import {alertDialog, confirmDialog, errorDialog} from '../../components/dialogs/ConfirmDialog';
import Paper from '@mui/material/Paper';
import {
    CheckBox,
    CheckBoxOutlineBlank,
    Delete,
    DeleteOutline,
    Edit,
    EditOutlined,
    ExpandMoreOutlined
} from '@mui/icons-material';
import MenuItem from "@mui/material/MenuItem";
import {loadClasses} from "../../components/data/classes";
import {loadProperties} from "../../components/data/properties";
import SectionHeader from "../../components/SectionHeader";
import PropertySection from './propertySection';

const ClassProperties: NextPage = () => {
    const [properties, setProperties] = useState([]);
    const [classes, setClasses] = useState([]);
    const [classProperties, setClassProperties] = useState({});
    const [loading, setLoading] = useState(false);
    const [addFormShowing, setAddFormShowing] = useState(false);
    const [classId, setClassId] = useState(0);
    const [propertyId, setPropertyId] = useState(0);

    const reloadProperties = () => {
        setLoading(true);
        loadProperties(setProperties)
          .then(() => setLoading(false));
    }

    const reloadClasses = () => {
        setLoading(true);
        loadClasses(setClasses)
          .then(() => setLoading(false));
    }

    const reloadClassProperties = () => {
        setLoading(true);
        setLoading(false);
    }

    const classesList = () => {
        if (classes.length === 0) {
            return (
              <>
                  <Stack direction={'row'}>
                      <StackItem sx={{width: '100%', padding: '1em', color: '#000'}}>
                          <Typography fontWeight={'bold'}>No classes have been defined yet.</Typography>
                      </StackItem>
                  </Stack>
              </>
            );
        }

        return classes.map((row) => (
          <PropertySection name={row.name} description={row.description} id={row.id} properties={properties}/>
        ));
    }

    useEffect(() => {
        reloadProperties();
        reloadClasses();
    }, []);

    if (loading) {
        return (
          <LoadingMessage label={'Retrieving class and property list, one moment ...'}/>
        );
    }

    return (
      <>
          <div sx={{width: '100%'}} style={{border: '1px solid #ddd', backgroundColor: '#fff'}}>
              <SectionHeader header={'Class Properties'}>
                  <Typography>
                      Class Properties are used to define the names and field types of data that can be stored
                      in an instance of a Class.
                  </Typography>
              </SectionHeader>

              {classesList()}
          </div>
      </>
    );
}

export default ClassProperties;
