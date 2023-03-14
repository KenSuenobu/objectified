import * as React from "react";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import AppBar from "@mui/material/AppBar";
import CssBaseline from "@mui/material/CssBaseline";
import Toolbar from "@mui/material/Toolbar";
import List from "@mui/material/List";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import InboxIcon from "@mui/icons-material/MoveToInbox";
import MailIcon from "@mui/icons-material/Mail";
import { NextPage } from "next";
import MainAppBar from "../components/MainAppBar";
import SideBar from "../components/SideBar";
import { SideBarMenuGroupProps } from "../components/SideBarMenuGroup";
import {
  ClassOutlined,
  FormatListBulletedOutlined,
  GroupsOutlined,
  PersonOutlined,
  ReorderOutlined,
  RuleOutlined,
  TypeSpecimenOutlined,
  ViewListOutlined,
  PublicOutlined, WorkspacesOutlined,
} from "@mui/icons-material";
import Namespaces from "./namespaces";
import DataTypes from './dataTypes';
import Fields from './fields';

const drawerWidth = 240;

const Home: NextPage = () => {
  const [currentPage, setCurrentPage] = React.useState(<></>);
  const componentsItems: SideBarMenuGroupProps = {
    label: "COMPONENTS",
    items: [
      {
        icon: <WorkspacesOutlined/>,
        label: "Namespaces",
        onClick: () => setCurrentPage(<Namespaces/>),
      },
      {
        icon: <TypeSpecimenOutlined/>,
        label: "Data Types",
        onClick: () => setCurrentPage(<DataTypes/>),
      },
      {
        icon: <ReorderOutlined/>,
        label: "Fields",
        onClick: () => setCurrentPage(<Fields/>),
      },
/*      {
        icon: <ClassOutlined/>,
        label: "Classes",
        onClick: () => setCurrentPage(<></>),
      },
      {
        icon: <FormatListBulletedOutlined/>,
        label: "Properties",
        onClick: () => setCurrentPage(<></>),
      },
      {
        icon: <PublicOutlined />,
        label: "Class Properties",
        onClick: () => setCurrentPage(<></>),
      },
      {
        icon: <ClassOutlined/>,
        label: "Schemas",
        onClick: () => setCurrentPage(<></>),
      },
      {
        icon: <ClassOutlined/>,
        label: "Instances",
        onClick: () => setCurrentPage(<></>),
      },
      {
        icon: <ClassOutlined/>,
        label: "Instance Data",
        onClick: () => setCurrentPage(<></>),
      },
*/
    ],
  };

  function callTest() {
    console.log('test');
  }

  return (
    <Box sx={{ display: "flex" }}>
      <CssBaseline />
      <SideBar width={260} sidebarItems={[componentsItems,]} />
      <Box
        component="main"
        sx={{ flexGrow: 1, p: 3 }}
        position={"relative"}
        left={260}
        marginRight={"260px"}
      >
        {currentPage}
      </Box>
    </Box>
  );
};

export default Home;
